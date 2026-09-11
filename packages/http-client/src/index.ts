/**
 * `@djobi/http-client` — how a djobi client talks to the djobi backend, stated once.
 *
 * This is deliberately **not** part of `@djobi/shared`. That package holds cross-process domain and
 * wire contracts — the shapes both halves have to agree on. HTTP execution is client
 * infrastructure, and keeping the layering visible is the point: a route schema is a fact about the
 * protocol, while a deadline and a retry rule are facts about how one side chooses to call it.
 *
 * It exists because the same protocol was implemented twice — `apps/extension/src/lib/callBackend.ts`
 * and `apps/dashboard/src/lib/dashboardClient.ts` — against the same Hono server, and the two had
 * already drifted in ways that were defects rather than differences of style:
 *
 * - The extension's deadline wrapped `fetch` alone, so a backend that answered its headers and then
 *   stalled mid-body hung forever. The dashboard's covered the body read.
 * - Both let a malformed 2xx body throw a raw `SyntaxError` out of `JSON.parse`, past the error type
 *   each module had defined for exactly that case.
 * - An unreachable backend read as "Failed to fetch" in the extension and as "Is it running? (pnpm
 *   dev:backend)" in the dashboard — the better message living in the app less likely to need it.
 * - `callBackendBinary` took no `AbortSignal` at all, so `/render-resume-pdf` — real generation cost
 *   inside the Fill Step — was the one route that could not be cancelled, because "every call takes
 *   a signal" was a convention re-remembered per function rather than a rule stated once.
 *
 * What stays with each app is what genuinely differs: its typed route surface, its fake adapter, and
 * its configuration. In particular the **origin is injected, never centralised** — see
 * {@link HttpTransportOptions.baseUrl}.
 */
import { BackendErrorBodySchema, failureMessage } from '@djobi/shared';
import type { BackendErrorCode, ZodError, ZodTypeAny, ZodTypeOf } from '@djobi/shared';

/**
 * Why a call failed, as a closed set.
 *
 * The four are worth telling apart because each has a different cause and a different fix, and
 * because callers render them differently:
 *
 * - `'http'` — the backend answered, with a non-2xx. Carries `status`.
 * - `'timeout'` — nothing came back inside the deadline, headers or body.
 * - `'network'` — nothing was reachable at all. Usually the local backend not running.
 * - `'invalid-response'` — a 2xx that lied: not JSON, or not the shape the route promised. Kept
 *   separate from `'http'` deliberately, because a failed request and a successful request whose
 *   body is wrong have nothing in common except the disappointment.
 */
export type HttpErrorKind = 'http' | 'timeout' | 'network' | 'invalid-response';

/** Any failed call to the djobi backend. One class, discriminated by {@link HttpErrorKind}. */
export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    readonly path: string,
    message: string,
    /** The response status, for `kind: 'http'` only. */
    readonly status?: number,
    /**
     * The error this one was mapped from, where there was one.
     *
     * Carried because the mapping is lossy on purpose: every `TypeError` out of `fetch` becomes one
     * `'network'` message written for the common cause, and without the original there is nothing
     * left to tell a genuinely unreachable backend from a request `fetch` refused to construct.
     */
    options?: {
      cause?: unknown;
      backendCode?: BackendErrorCode;
      /**
       * The part of `message` fit to show a candidate, when it differs from `message` itself — see
       * {@link HttpError.reason}. Omitted, `reason` falls back to `message`, which is already clean
       * enough for `'network'`/`'timeout'` — neither carries the `"$METHOD $path failed ($status):"`
       * diagnostic prefix `'http'`'s `message` does, or the raw body/zod-issue dump
       * `'invalid-response'`'s does.
       */
      reason?: string;
    },
  ) {
    super(message, options);
    this.name = 'HttpError';
    this.backendCode = options?.backendCode;
    this.reason = options?.reason ?? message;
  }

  /** A safe semantic classification supplied by the backend, independent of transport kind. */
  readonly backendCode?: BackendErrorCode;

  /**
   * The text fit to show the candidate who triggered this call — never the diagnostic
   * `"$METHOD $path failed ($status):"` prefix `message` carries for a `'http'` kind, and never a
   * zod issue list or a raw non-JSON body for an `'invalid-response'` kind. Every UI surface that
   * displays a caught error should read this, not `message`/`failureMessage(error)` — those stay
   * exactly what they were, the fuller string every existing `console.error` and test already reads.
   */
  readonly reason: string;
}

/**
 * Whether `err` is this transport reporting the backend's own 401 — an absent or expired session.
 *
 * Written identically four times across both apps (`apps/extension/src/options/App.tsx`,
 * `apps/extension/src/lib/authClient.ts`, `apps/extension/src/background/pipelineFailure.ts`,
 * `apps/dashboard/src/lib/dashboardSession.ts`) before landing here — every caller reached past this
 * module's own seam to inspect `HttpError`'s shape for itself, which meant the shape could never
 * change without hunting down four copies.
 *
 * Deliberately narrow: it means exactly "an `HttpError` with `kind: 'http'` and `status: 401`," and
 * nothing about *why* — a wrong password looks the same on the wire as an expired session (both are
 * a 401 from `requireAuth`), so this cannot tell them apart. Session policy — sign the candidate out,
 * offer a retry, redirect to sign-in — stays each caller's own call; this only answers the one
 * question every one of them was asking before doing something about it.
 */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.kind === 'http' && err.status === 401;
}

/**
 * The text fit to show whoever triggered `error` — `HttpError.reason` for one of these, or
 * `failureMessage`'s generic reading of anything else.
 *
 * Every place in either app that turns a caught error into UI text should call this instead of
 * `failureMessage` directly. `failureMessage(new HttpError(...))` reads the *diagnostic* `message` —
 * `"POST /api/auth/sign-in/email failed (401): {\"message\":\"Invalid email or password\", …}"` was
 * a caller doing exactly that — which is correct for a log line and wrong for a banner a candidate
 * reads.
 */
export function userMessage(error: unknown): string {
  return error instanceof HttpError ? error.reason : failureMessage(error);
}

export interface HttpTransportOptions {
  /**
   * Prefixed to every path. **Injected rather than centralised**, because the two apps genuinely
   * differ once deployed (ADR-0001): the dashboard is served from the same Worker origin as the API
   * and wants a relative `'/api'`, while the extension has no origin of its own and needs an
   * absolute URL — one that must *also* match its `host_permissions` entry in `manifest.ts`, so it
   * has to be build-time visible in a way the dashboard's does not.
   */
  baseUrl: string;
  /**
   * How long any one call may take, headers *and* body, before it is abandoned. Defaults to 90s.
   *
   * `fetch` has no deadline of its own, so a request that never completes never settles and an
   * Analysis Step's `Promise.all` waits on it forever. Aborting also reaches the model: the backend
   * hands each request's signal down to the SDK, so giving up here stops the generation rather than
   * merely stopping the wait.
   */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
  /**
   * What to say when nothing is reachable. App-specific because the remedy is: the dashboard user
   * starts the backend, the extension user may have it running and be blocked by a permission.
   */
  unreachableMessage?: string;
  /**
   * `fetch`'s own `credentials` mode, applied to every call this transport makes.
   *
   * A transport-level default rather than a per-call `RequestOptions` field: the dashboard
   * (`docs/multi-tenant-auth.md`, Phase C) authenticates by httpOnly cookie, so *every* call it makes
   * needs `'include'` or the session cookie never leaves the browser on a cross-origin request — there
   * is no call site that would ever want a dashboard request sent without it. The extension has no
   * cookie of its own (`Authorization: Bearer`, attached by the caller instead) and leaves this unset,
   * which keeps `fetch`'s own default (`'same-origin'`).
   */
  credentials?: RequestCredentials;
  /**
   * Resolves the bearer token to send as `Authorization: Bearer <token>` on every call, or
   * `undefined` for none. A function rather than a fixed string: the extension's token lives in
   * `chrome.storage.session` (`docs/multi-tenant-auth.md`, Phase D) and can change — sign-in,
   * sign-out, a session that expires — after `createHttpTransport` is called once at module scope, so
   * a value captured at construction time would go stale the first time that happened. Called fresh
   * before every request; may be async, since reading `chrome.storage.session` is. The dashboard has
   * no use for this — its session is the httpOnly cookie `credentials` already carries — and leaves
   * it unset.
   */
  getAuthorization?: () => string | undefined | Promise<string | undefined>;
}

/** One request's options. `method` defaults to `'POST'` when a body is given, `'GET'` when not. */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * The caller's own cancellation, combined with the deadline rather than replacing it.
   *
   * Load-bearing for the extension: a pipeline run supplies this so that re-analysis stops the model
   * work the superseded run started. An abort from here propagates as itself — never rewritten into
   * a `'timeout'` — because the caller asked for it and a caller that cancelled is not a failure to
   * report.
   */
  signal?: AbortSignal;
  /**
   * Sent as `idempotency-key`, for a write a caller might resend after a timeout or a lost
   * response — `POST /applications` is the one route that reads it (see
   * `applicationStore.ts`'s `create`). The transport only carries it; deduping on it is the
   * server's job, so a caller that never retries never needs one.
   */
  idempotencyKey?: string;
}

export interface HttpTransport {
  /** Sends `path` and decodes the response through `schema`. */
  json<Schema extends ZodTypeAny>(
    path: string,
    schema: Schema,
    options?: RequestOptions,
  ): Promise<ZodTypeOf<Schema>>;
  /** Sends `path` and returns the raw response bytes — for a route that answers with a PDF. */
  binary(path: string, options?: RequestOptions): Promise<ArrayBuffer>;
  /**
   * Sends `formData` as a multipart file upload and decodes the JSON response through `schema` —
   * for `POST /profile/extract-resume`, the one route that takes a file rather than JSON.
   *
   * `formData` is sent exactly as given: never `JSON.stringify`'d, and with no `content-type` set
   * here, so `fetch` supplies its own header carrying the multipart boundary. The backend's own
   * CSRF guard treats `application/json` as implicitly safe (see `apps/backend/src/app.ts`) because
   * it forces a CORS preflight the origin allowlist gets to refuse — `multipart/form-data` cannot
   * get that same protection from its content-type alone, since it is itself one of the three CORS
   * "simple" types. `x-djobi-upload` is what forces the same preflight for this call; it is added
   * here, once, rather than at every call site that might otherwise forget it.
   */
  upload<Schema extends ZodTypeAny>(
    path: string,
    schema: Schema,
    formData: FormData,
    options?: { signal?: AbortSignal },
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
 * Best-effort extraction of a human-readable reason from an error response body. Handles the
 * backend's `{ error }` shape (`app.onError` and route validation alike), and falls back to the raw
 * text for anything that isn't JSON at all — a crash outside the backend's own error handling, or
 * nothing listening on the port, still produces a readable message.
 */
export function errorBodyFrom(raw: string): { reason: string; backendCode?: BackendErrorCode } {
  try {
    const parsed: unknown = JSON.parse(raw);

    const body = BackendErrorBodySchema.safeParse(parsed);
    if (body.success) return { reason: body.data.error, backendCode: body.data.code };

    // A route that put an `Error`-like object under `error` rather than a string.
    const message = (parsed as { error?: { message?: unknown } })?.error?.message;
    if (typeof message === 'string') return { reason: message };

    // Better Auth's own error body (`/api/auth/*` — a pass-through past this app's `{ error }`
    // convention, see `app.ts`): a top-level `message`, e.g. `{"message":"Invalid email or
    // password","code":"INVALID_EMAIL_OR_PASSWORD"}`. Without this branch that whole object fell
    // through to the raw-text case below and was shown to the candidate verbatim, braces and all.
    const topLevelMessage = (parsed as { message?: unknown })?.message;
    if (typeof topLevelMessage === 'string') return { reason: topLevelMessage };
  } catch {
    // Not JSON — fall through and use the raw body below.
  }
  return { reason: raw.trim().slice(0, 300) || 'empty response body' };
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * `POST` when there is a body, `GET` when there isn't — unless the caller says otherwise.
 *
 * Shared by the request and by the messages describing it, so a failure names the method that was
 * actually sent rather than one re-derived beside it.
 */
function resolveMethod(options: RequestOptions): 'GET' | 'POST' | 'PATCH' | 'DELETE' {
  return options.method ?? (options.body === undefined ? 'GET' : 'POST');
}

/**
 * A promise that rejects when `signal` aborts, for racing against a body read.
 *
 * Needed because aborting only tears down a response body that the platform's own `fetch` created
 * and wired to that signal. Racing makes the deadline cover the body read *by construction* rather
 * than by relying on that wiring — which also makes it something a test with an injected `fetch`
 * can actually verify, instead of a property that only holds in production.
 */
function abortedWith(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Resolved per call, not captured here: a transport is created at module scope, and reading the
  // global once at that moment freezes whatever `fetch` existed at import time — which is the
  // original in any suite that installs a stub afterwards, and a missing one wherever a polyfill
  // lands late. An explicitly injected `fetch` is honoured as given.
  const doFetch = (input: string, init: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(input, init);

  /**
   * Runs one call end to end — request *and* body read — under a single deadline.
   *
   * `read` is taken as a callback rather than the response being returned, so that consuming the
   * body happens inside this `try`. That is the whole of the extension's old bug: its deadline
   * wrapped `fetch` alone, so a backend that sent headers and then stalled was never abandoned.
   *
   * The status check happens *before* `read` for the same reason it always did: parsing first turns
   * a real HTTP failure into an unrelated `SyntaxError` — a plain-text `Internal Server Error`
   * throws `Unexpected token 'I'` — which is how a 500 used to reach a UI as a parse error.
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
          // guard (`app.ts`) requires that header of every POST/PATCH/PUT/DELETE, because a request
          // carrying it is never a CORS "simple request" and so must be preflighted — which is
          // exactly as true of a body-less `DELETE …/notes/:id` as of a POST with a payload. A GET
          // declares nothing, having nothing to declare.
          method === 'GET'
          ? { method }
          : { method, headers: { 'content-type': 'application/json' } }
        : body instanceof FormData
          ? { method, headers: { 'x-djobi-upload': '1' }, body }
          : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

    // `fetch` rejects a GET carrying a body with a `TypeError` — indistinguishable, by the time it
    // reaches the catch below, from nothing listening on the port, so the caller would be told to
    // start a backend that is already running. It is a caller bug either way, so it is raised as
    // itself here rather than sent and mistranslated. Not silently dropped: a request whose body
    // vanished is worse than one that refused to be sent.
    if (method === 'GET' && body !== undefined) {
      throw new Error(`GET ${path} was given a body; use POST, or send it in the path.`);
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const deadline = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      // Resolved fresh per call, not once at transport construction — see `getAuthorization`'s own
      // comment for why a captured value would go stale. Awaited before the headers are built, so a
      // GET (which otherwise has none) still gets an `Authorization` header when there is a token.
      //
      // The conditional guards a real behavior difference, not just a style preference: `await
      // undefined` still suspends this async function for a microtask, which delays `doFetch` below
      // past the point a caller's synchronous `signal.abort()` (called right after this function is
      // invoked, before anything here has awaited) would otherwise be observed by a listener that
      // registers on call. Every transport without `getAuthorization` set — the dashboard included —
      // must see exactly the old synchronous-up-to-`doFetch` behavior, which skipping the `await`
      // entirely preserves.
      //
      // Now inside the `try`/under the deadline: a rejecting `getAuthorization()` (e.g.
      // `chrome.storage.session` unavailable during service-worker teardown) is mapped to an
      // `HttpError` like every other failure here, instead of escaping as a raw error past callers
      // that branch on `HttpError.kind`/`.status`.
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

      // Every body read is raced against the same deadline the request ran under, the failure path
      // included: a backend that answers `500` and then stalls sending the reason must not hang
      // either.
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
          `${path} did not respond within ${Math.round(timeoutMs / 1000)}s`,
          undefined,
          { reason: 'This is taking longer than expected. Please try again.' },
        );
      }

      // `fetch` rejects with a `TypeError` when it cannot reach anything at all. On its own that
      // reads as "Failed to fetch", which tells nobody anything.
      //
      // A `TypeError` can also mean a request `fetch` would not construct — a malformed URL, a
      // forbidden header — which this message describes wrongly. The GET-with-a-body case, the one
      // this transport could actually produce, is refused above; the rest keep the original as
      // `cause`, so the real reason is one hop away rather than gone.
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

  /**
   * The `json()`/`upload()` decode step: text in, `schema`-checked object out. Shared because an
   * upload's response is JSON exactly like every other route's — only how the *request* body is
   * built differs, which `call()`'s own branch on `body instanceof FormData` already covers.
   */
  function decodeJson<Schema extends ZodTypeAny>(
    path: string,
    method: string,
    raw: string,
    schema: Schema,
  ): ZodTypeOf<Schema> {
    let parsed: unknown;
    // Shown to whoever triggered the call that hit either branch below — never the raw body or the
    // zod issue list `message` carries for the log: that detail is a bug report artifact, not
    // something a candidate can act on.
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
