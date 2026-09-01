/**
 * `requireAuth()` in isolation, against the real Better Auth handler over PGlite (same migration
 * chain `auth.test.ts` runs) — not wired into `app.ts` yet, see that module's own doc comment for
 * why. A throwaway Hono app with one protected route stands in for the real one until it is.
 */
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthEnv } from './authMiddleware.js';

vi.mock('./db/client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('./db/schema.js');
  const authMiddlewareTestClient = new PGlite();
  return { db: drizzle(authMiddlewareTestClient, { schema }), authMiddlewareTestClient };
});

const { authMiddlewareTestClient } = (await import('./db/client.js')) as unknown as {
  authMiddlewareTestClient: PGlite;
};
const { auth } = await import('./auth.js');
const { requireAuth } = await import('./authMiddleware.js');

beforeAll(async () => {
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const schema = await import('./db/schema.js');
  await migrate(drizzle(authMiddlewareTestClient, { schema }), {
    migrationsFolder: new URL('./db/migrations', import.meta.url).pathname,
  });
});

const app = new Hono<AuthEnv>();
app.get('/protected', requireAuth(), (c) => c.json({ userId: c.get('userId') }));

async function signUp(email: string): Promise<Response> {
  return auth.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'correct horse battery staple', name: 'Test User' }),
    }),
  );
}

describe('requireAuth', () => {
  it('answers 401 with no credential at all', async () => {
    const res = await app.request('/protected');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
  });

  it('answers 401 for a garbage bearer token', async () => {
    const res = await app.request('/protected', {
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    expect(res.status).toBe(401);
  });

  it('answers 401 for a garbage cookie', async () => {
    const res = await app.request('/protected', {
      headers: { cookie: 'better-auth.session_token=not-a-real-token' },
    });

    expect(res.status).toBe(401);
  });

  it('sets userId from a valid session cookie', async () => {
    const signUpRes = await signUp('cookie-user@example.com');
    const cookie = signUpRes.headers.get('set-cookie');
    expect(cookie).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie!.split(';')[0] }),
    });
    expect(session).not.toBeNull();

    const res = await app.request('/protected', {
      headers: { cookie: cookie!.split(';')[0] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: session!.user.id });
  });

  it('sets userId from a valid bearer token', async () => {
    const signUpRes = await signUp('bearer-user@example.com');
    const token = signUpRes.headers.get('set-auth-token');
    expect(token).toBeTruthy();

    const res = await app.request('/protected', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  });
});
