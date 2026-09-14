import type { BackendErrorBody } from '@djobi/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { ErrorHandler, MiddlewareHandler } from 'hono';
import { auth } from './auth.js';
import type { AuthEnv } from './authMiddleware.js';
import { StructuredCallError } from './llm/structuredCall.js';
import { publicOrigins } from './publicOrigins.js';
import { RequestValidationError } from './requestBody.js';
import type { ApplicationStore } from './db/applicationStore.js';
import type { ProfileStore } from './db/profileStore.js';
import { applicationsRoute } from './routes/applications.js';
import { llmRoutes } from './routes/llm.js';
import { profileRoute } from './routes/profile.js';
import { renderResumePdfRoute } from './routes/render-resume-pdf.js';

/**
 * What the app needs from the outside world, and the only thing `index.ts` supplies.
 *
 * `requireAuth` is a dependency for the same reason the two stores are: `authMiddleware.ts`'s real
 * `requireAuth()` reaches through `auth.ts` into the real (lazy) `db` the first time a request
 * actually calls it, and hardcoding that into every request this app serves would force every route
 * test — most of which have nothing to do with auth — into either a real Better Auth sign-up or
 * losing the documented "importable with no `.env`" property. `testApp.ts` supplies
 * `authMiddleware.ts`'s `fakeAuth`/`fakeUnauthenticated` instead, the same role
 * `inMemoryApplicationStore`/`inMemoryProfileStore` already play for persistence.
 *
 * The four LLM operations and the PDF renderer reach their own upstreams and are substituted at
 * their own seams (`llm/fakeModel.ts`, and a `vi.mock` of `pdf/renderResume.js`), which is why they
 * are not here. Adding a dependency to this interface is a deliberate widening of what the app
 * cannot construct for itself.
 */
export interface AppDependencies {
  applicationStore: ApplicationStore;
  profileStore: ProfileStore;
  requireAuth: MiddlewareHandler<AuthEnv>;
}

/**
 * The one place a thrown error becomes a response. No route has its own `try/catch`, so without
 * this every throw from `llm/` — the model not returning a tool call, or its input failing schema
 * validation (`structuredCall.ts`), or an SDK/network failure — fell through to Hono's default
 * handler and became a *plain-text* `Internal Server Error`. That body isn't JSON, so the
 * extension's `callBackend` blew up parsing it and the real cause was destroyed before anyone
 * could read it. Failures now use the same `{ error }` shape the routes' validation errors
 * already return, so one client-side branch handles both.
 *
 * Exported (rather than an inline `app.onError` closure) so it can be driven directly against a
 * throwing route in a test, without needing `createApp`'s full dependencies.
 */
export const handleError: ErrorHandler<AuthEnv> = (err, c) => {
  const context = `${c.req.method} ${c.req.path}`;

  // The candidate closed the panel, navigated away, or hit Re-analyze — the request was abandoned
  // and every model call under it was aborted on purpose. Nothing failed, so nothing is logged and
  // no 500 is recorded: the same judgement the rejected-body branch below makes, for the same
  // reason. Putting an ordinary user action through the channel that means "the backend is broken"
  // is what makes that channel worth ignoring. The response goes nowhere; the status is for the log.
  // 499 is the "client closed request" convention; Hono's `StatusCode` union is IANA-only, so the
  // number is set on a plain `Response` rather than through `c.body`.
  if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });

  // A rejected body is the client's fault, so it is a 400 and it is not logged. Logging it would
  // put "the request was bad" through the same channel as "the backend is broken", which is the
  // channel someone reads when deciding whether to go looking at the backend.
  if (err instanceof RequestValidationError) {
    const body: BackendErrorBody = { error: err.message };
    return c.json(body, 400);
  }

  // Hono's own middleware (`hono/body-limit`, `hono/validator`, …) signals an expected, client-side
  // rejection this way — its own status and body are already the right response, not a fault of
  // this backend's to log. `getResponse()` is unaware of anything this app's own middleware already
  // set on `c` (headers, etc.), which is fine here: nothing upstream of `onError` sets any.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  if (err instanceof StructuredCallError) {
    console.error(`[djobi] ${context} failed`, {
      name: err.name,
      message: err.message,
      kind: err.kind,
      toolName: err.toolName,
      requestId: err.requestId,
      stopReason: err.stopReason,
    });
  } else {
    console.error(`[djobi] ${context} failed:`, err);
  }

  const body: BackendErrorBody = {
    error: 'Internal server error',
    ...(err instanceof StructuredCallError ? { code: 'invalid-model-output' as const } : {}),
  };

  return c.json(body, 500);
};

/**
 * Builds the Hono app over its dependencies — separated from `index.ts` (which calls `serve()`) so
 * it can be driven with `app.request(...)` without binding a real port, and separated from its
 * stores so it can be driven without a database.
 *
 * It is a function rather than a module-level instance because the app now *has* dependencies. As a
 * singleton, the only way to give a test different persistence was to replace the store's module
 * with `vi.mock`, which four test files did — each restating the store's full export surface by
 * hand. A parameter cannot be forgotten the way that convention could, and two tests can now hold
 * two independent apps instead of sharing one and resetting mocks between cases.
 */
export function createApp(deps: AppDependencies): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  /**
   * Cross-origin access for `apps/dashboard`, which runs on its own dev server and is therefore a
   * different origin from this one.
   *
   * Two things about this registration are load-bearing.
   *
   * It sits **before** every `app.route` below. Hono composes handlers in registration order, so
   * middleware added after the routes never runs for a request a route answers — it still runs for a
   * 404, which is a convincing way to look correct while doing nothing. The same trap is written up
   * in `index.ts` for the logger.
   *
   * And the origin is an explicit list rather than `*`. This server holds an Anthropic API key and a
   * live database connection, and *any* page in the browser can reach `127.0.0.1` — a wildcard would
   * let an unrelated site the candidate happens to have open read their applications. `credentials:
   * true` and an explicit list are a package deal: the fetch spec forbids a wildcard origin on a
   * credentialed response outright, so this could not be `*` even before that reasoning.
   *
   * `credentials: true` is what lets the browser both send the dashboard's httpOnly session cookie
   * on a cross-origin request and expose the response to it — without it, `auth.ts`'s cookie-based
   * session (Phase B) can never reach `deps.requireAuth` from `apps/dashboard`, which runs on its own
   * dev server (`docs/multi-tenant-auth.md`, Phase C). The extension's `Authorization: Bearer` path
   * needs none of this — a header a script sets itself was never subject to the cookie jar — so this
   * is purely for the dashboard's benefit.
   *
   * Note what this allowlist does **not** do on its own: it stops cross-origin *reads*, because the
   * browser withholds a response the server didn't label for that origin. It does not stop every
   * cross-origin *write*. CORS middleware is header-based — for a non-`OPTIONS` request it omits the
   * allow-origin header and calls `next()` anyway — so a request the browser never preflights
   * reaches the handler and its side effect lands, even though the attacker can't read the reply.
   * The content-type guard below is what closes that hole.
   */
  app.use(
    '*',
    cors({
      // `PUBLIC_ORIGINS` (comma-separated) appends real deployed origins to the local-dev pair
      // rather than replacing them — the same env var `auth.ts`'s `trustedOrigins` reads, through
      // the same `publicOrigins()`, so the two allowlists (this one for the browser's CORS check,
      // that one for Better Auth's own origin check) can't drift out of sync on a real deploy.
      origin: ['http://localhost:5174', 'http://127.0.0.1:5174', ...publicOrigins()],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // `x-djobi-upload` exists purely to force a preflight — see the content-type middleware below
      // for why `POST /profile/extract-resume` needs one despite not sending JSON.
      // `idempotency-key` is `routes/applications.ts`'s dedupe token for `POST /applications` — see
      // `applicationStore.ts`'s `create`.
      allowHeaders: ['content-type', 'x-djobi-upload', 'idempotency-key'],
      credentials: true,
    }),
  );

  /**
   * Every state-changing request must declare `content-type: application/json`.
   *
   * This is a CSRF guard, not a parsing convenience. A `POST` counts as a CORS "simple request" —
   * and so is sent with no preflight for the allowlist above to reject — only when its content-type
   * is `text/plain`, `application/x-www-form-urlencoded`, or `multipart/form-data`. `c.req.json()`
   * parses the body regardless of the header, so without this an unrelated page could `fetch` a
   * `text/plain` POST at `127.0.0.1` and overwrite the whole profile, including the work-authorization
   * and sponsorship answers the extension then submits verbatim on the next application.
   *
   * `application/json` is never simple, so requiring it forces a preflight the allowlist gets to
   * refuse. Both real clients (`extension/src/lib/callBackend.ts`, `dashboard/src/lib/dashboardClient.ts`)
   * already send it. `PATCH` never preflight-exempts either way, but it is covered here too rather
   * than leaving the rule to be re-derived per method.
   */
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE') {
      return next();
    }

    // Split on `;` — a browser may append `charset=utf-8`, which is still JSON, or a multipart
    // boundary.
    const contentType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();

    // `POST /profile/extract-resume` (20.3) sends a file, which cannot be `application/json`. But
    // `multipart/form-data` is itself one of the three CORS "simple" content types the comment above
    // names — accepting it here with no further check would quietly reopen the exact hole this
    // middleware exists to close, just for this one route. `x-djobi-upload` is not a simple header,
    // so requiring it demands the same preflight `application/json` gets for free: an attacker's
    // page can set the header, but the browser then withholds the real request until the origin
    // allowlist above answers the preflight, which an unrelated origin never gets.
    if (contentType === 'multipart/form-data' && c.req.header('x-djobi-upload')) {
      return next();
    }

    if (contentType !== 'application/json') {
      const body: BackendErrorBody = {
        error: `${method} requires content-type: application/json`,
      };
      return c.json(body, 415);
    }

    return next();
  });

  // Unlike the middleware above, registration order doesn't matter for these two: Hono calls
  // `onError`/`notFound` on a throw or an unmatched route regardless of where they're registered.
  app.onError(handleError);
  app.notFound((c) => {
    // The same `{ error }` shape every other rejected request already answers with, so an unknown
    // path (a stale extension build hitting a route this backend has since removed, say) is still
    // JSON `userMessage(error)` can read, not Hono's plain-text default.
    const body: BackendErrorBody = { error: 'Not found' };
    return c.json(body, 404);
  });

  /**
   * Better Auth's own routes — `/api/auth/sign-up/email`, `/sign-in/email`, `/sign-in/social`,
   * the session endpoints, and (once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set, see
   * `.env.example`) the Google OAuth callback. `auth.handler` is Better Auth's own Fetch-standard
   * handler, so this is a pass-through rather than a route this file has any business parsing —
   * see `auth.ts` for what's actually configured.
   *
   * Registered after the CORS and content-type middleware above, so a sign-up POST gets the same
   * CSRF-relevant content-type check every other state-changing route already gets — and **before**
   * `deps.requireAuth` below, which is what has to stay true: signing up or signing in is exactly
   * the thing an unauthenticated request needs to be able to do. Hono composes in registration
   * order, so a request matching this route never reaches the middleware registered after it.
   */
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  /**
   * Everything below this line requires a session. `docs/multi-tenant-auth.md`'s Phase B: routes
   * that don't themselves scope on `userId` (the four LLM operations, PDF rendering) still sit
   * behind this — an unauthenticated caller has no business spending this backend's OpenRouter
   * budget just because a given route doesn't happen to read the id it authenticated.
   */
  app.use('*', deps.requireAuth);

  app.route('/', llmRoutes);
  app.route('/', profileRoute(deps.profileStore));
  app.route('/', renderResumePdfRoute);
  app.route('/', applicationsRoute(deps.applicationStore));

  return app;
}
