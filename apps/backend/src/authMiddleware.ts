/**
 * Session verification, injected into `createApp` as `requireAuth`. `fakeAuth` and
 * `fakeUnauthenticated` are the test adapters.
 */
import type { BackendErrorBody } from '@djobi/shared';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { auth } from './auth.js';

/** Context variables set by this middleware — handlers read `c.get('userId')`. */
export type AuthEnv = { Variables: { userId: string } };

/**
 * Reads a session (cookie or bearer) and sets `userId`, or answers 401 with `{ error }`. Never
 * throws: an expired session is an ordinary 401, not a fault to log.
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

/** Test middleware that always authenticates as `userId`, touching no session or database. */
export function fakeAuth(userId: string): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next: Next) => {
    c.set('userId', userId);
    await next();
  };
}

/** Test middleware that always answers 401. */
export function fakeUnauthenticated(): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>) => {
    const body: BackendErrorBody = { error: 'Authentication required' };
    return c.json(body, 401);
  };
}
