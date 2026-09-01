/**
 * Session verification — Phase B (`docs/multi-tenant-auth.md`). Now wired into `app.ts` as an
 * injected `AppDependencies.requireAuth`, exactly as `ApplicationStore`/`ProfileStore` already are:
 * `requireAuth()` itself reaches through `auth.ts` into the real `auth.api.getSession`, which touches
 * the real (lazy) `db` the first time it's called — hardcoding it into every request `createApp`
 * serves would force every route test to either perform a real Better Auth sign-up or lose the
 * documented "importable with no `.env`" property most of them rely on. `fakeAuth`/`fakeUnauthenticated`
 * below are `testApp.ts`'s adapter, the same seam `inMemoryApplicationStore`/`inMemoryProfileStore`
 * already are for persistence.
 */
import type { BackendErrorBody } from '@djobi/shared';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { auth } from './auth.js';

/**
 * The `Variables` every downstream handler can read once this middleware has run — `c.get('userId')`
 * rather than a `userId` threaded through every function signature by hand.
 */
export type AuthEnv = { Variables: { userId: string } };

/**
 * Reads a session — httpOnly cookie or `Authorization: Bearer <token>`, both handled by
 * `auth.api.getSession` once `auth.ts`'s `bearer()` plugin is enabled — and either sets `userId` in
 * context or answers 401 in the same `{ error }` shape every other rejected request already uses,
 * so one client-side branch handles both. Never throws: an unreadable or expired session is an
 * ordinary 401, not a fault `app.onError` needs to log.
 */
export function requireAuth(): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      const body: BackendErrorBody = { error: 'Authentication required' };
      return c.json(body, 401);
    }

    c.set('userId', session.user.id);
    await next();
  };
}

/**
 * A `requireAuth`-shaped middleware that always succeeds as `userId`, for tests — the same role
 * `inMemoryApplicationStore` plays for persistence. No session is read, no `auth.ts` import
 * touched, so a test using this pays nothing toward the real Better Auth/Postgres path.
 */
export function fakeAuth(userId: string): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    c.set('userId', userId);
    await next();
  };
}

/**
 * A `requireAuth`-shaped middleware that always answers 401 — for a test asserting what happens
 * with no (or an invalid) credential, without needing to construct a real expired/garbage session.
 */
export function fakeUnauthenticated(): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>) => {
    const body: BackendErrorBody = { error: 'Authentication required' };
    return c.json(body, 401);
  };
}
