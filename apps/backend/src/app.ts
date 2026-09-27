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
 * What `createApp` can't construct itself; `index.ts` supplies the real ones. `requireAuth` is
 * injected (like the stores) so route tests can use `fakeAuth` without a database or `.env`. LLM
 * calls and PDF rendering are faked at their own seams (`llm/fakeModel.ts`, `vi.mock`).
 */
export interface AppDependencies {
  applicationStore: ApplicationStore;
  profileStore: ProfileStore;
  requireAuth: MiddlewareHandler<AuthEnv>;
}

/**
 * The one place a thrown error becomes a response: a JSON `{ error, code? }` body, so clients
 * handle route validation errors and failures with one branch. Exported for direct testing.
 */
export const handleError: ErrorHandler<AuthEnv> = (err, c) => {
  const context = `${c.req.method} ${c.req.path}`;

  // The client abandoned the request (panel closed, Re-analyze) and its model calls were aborted on
  // purpose — not a failure, so nothing is logged. 499 is the "client closed request" convention;
  // Hono's `StatusCode` type is IANA-only, hence a plain `Response`.
  if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });

  // A bad body is the client's fault: 400, not logged.
  if (err instanceof RequestValidationError) {
    const body: BackendErrorBody = { error: err.message };
    return c.json(body, 400);
  }

  // Hono middleware (body-limit, validator, …) signals expected client rejections this way; its
  // response is already correct and not logged.
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
 * Builds the Hono app over its dependencies — no port bound (`index.ts` serves it) and no database
 * required, so tests drive it with `app.request(...)`.
 */
export function createApp(deps: AppDependencies): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  /**
   * CORS for the dashboard. Registered before every route (Hono runs middleware in registration
   * order). An explicit origin list, never `*`: this server holds an OpenRouter key and any page in
   * the browser can reach `127.0.0.1`. `credentials: true` lets the dashboard's session cookie
   * through; the extension uses a bearer header and doesn't need it.
   *
   * CORS only blocks cross-origin *reads*; an un-preflighted write still reaches its handler. The
   * content-type guard below closes that.
   */
  app.use(
    '*',
    cors({
      // `PUBLIC_ORIGINS` adds deployed origins; shared with `auth.ts`'s `trustedOrigins`.
      origin: ['http://localhost:5174', 'http://127.0.0.1:5174', ...publicOrigins()],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // `x-djobi-upload` forces a preflight for multipart uploads (see below); `idempotency-key`
      // dedupes `POST /applications`.
      allowHeaders: ['content-type', 'x-djobi-upload', 'idempotency-key'],
      credentials: true,
    }),
  );

  /**
   * CSRF guard: every state-changing request must be `content-type: application/json`. A
   * `text/plain`, form-encoded or multipart POST is a CORS "simple request" sent with no preflight,
   * and `c.req.json()` parses regardless of the header — so any page could otherwise overwrite the
   * Profile. JSON forces a preflight the origin allowlist can refuse.
   */
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE') {
      return next();
    }

    // Split on `;` — a browser may append `charset=utf-8`, which is still JSON, or a multipart
    // boundary.
    const [mediaType = ''] = (c.req.header('content-type') ?? '').split(';');
    const contentType = mediaType.trim().toLowerCase();

    // `POST /profile/extract-resume` sends multipart, itself a "simple" type. Requiring the
    // non-simple `x-djobi-upload` header forces the same preflight JSON gets.
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
    // JSON `{ error }` like every other rejection, not Hono's plain-text 404.
    const body: BackendErrorBody = { error: 'Not found' };
    return c.json(body, 404);
  });

  /**
   * Unauthenticated liveness check (used by Docker Compose). Deliberately shallow: confirms the
   * HTTP server is up, not Postgres or OpenRouter.
   */
  app.get('/healthz', (c) => c.json({ ok: true }));

  /**
   * Better Auth's routes (email/password, session, and Google OAuth when configured), passed
   * straight to `auth.handler`. After the CORS/content-type guards, and before `requireAuth` so
   * signing in doesn't need a session.
   */
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  /**
   * Everything below requires a session — including routes that don't scope by `userId` (LLM
   * operations, PDF rendering), so unauthenticated callers can't spend the OpenRouter budget.
   */
  app.use('*', deps.requireAuth);

  app.route('/', llmRoutes);
  app.route('/', profileRoute(deps.profileStore));
  app.route('/', renderResumePdfRoute);
  app.route('/', applicationsRoute(deps.applicationStore));

  return app;
}
