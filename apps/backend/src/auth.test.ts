/**
 * Better Auth mounted against real Postgres (PGlite), driven through every migration file rather
 * than a hand-built schema — the same reasoning `db/database.integration.test.ts` and
 * `db/applicationStore.contract.test.ts` already follow: the SQL Better Auth actually runs is the
 * behaviour worth checking, not a second hand-written imitation of the schema.
 *
 * Running the full migration chain (0000–0011) rather than just the newest also means this is the
 * first test that would notice a migration disagreeing with `db/schema.ts`'s current shape.
 */
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./db/client.js', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('./db/schema.js');
  const authTestClient = new PGlite();
  return { db: drizzle(authTestClient, { schema }), authTestClient };
});

const { authTestClient } = (await import('./db/client.js')) as unknown as {
  authTestClient: PGlite;
};
const { auth } = await import('./auth.js');

beforeAll(async () => {
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const schema = await import('./db/schema.js');
  await migrate(drizzle(authTestClient, { schema }), {
    migrationsFolder: new URL('./db/migrations', import.meta.url).pathname,
  });
});

/** Better Auth answers plain JSON; `Response.json()` is enough to read either a body or an error. */
async function callAuth(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await auth.handler(
    new Request(`http://localhost/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

describe('email/password sign-up and sign-in', () => {
  it('creates a users row with a real (uuid) id on sign-up', async () => {
    const { status, json } = await callAuth('/sign-up/email', {
      email: 'jane@example.com',
      password: 'correct horse battery staple',
      name: 'Jane Doe',
    });

    expect(status).toBe(200);
    const user = (json as { user: { id: string; email: string } }).user;
    expect(user.email).toBe('jane@example.com');
    // Better Auth's default id is a random base62 string; `advanced.database.generateId: 'uuid'`
    // in `auth.ts` is what makes this match instead — a `uuid` column would otherwise reject it.
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('signs back in with the same credentials and gets a session', async () => {
    await callAuth('/sign-up/email', {
      email: 'sam@example.com',
      password: 'correct horse battery staple',
      name: 'Sam Rivera',
    });

    const { status, json } = await callAuth('/sign-in/email', {
      email: 'sam@example.com',
      password: 'correct horse battery staple',
    });

    expect(status).toBe(200);
    expect((json as { user: { email: string } }).user.email).toBe('sam@example.com');
  });

  it('rejects a wrong password rather than issuing a session', async () => {
    await callAuth('/sign-up/email', {
      email: 'alex@example.com',
      password: 'correct horse battery staple',
      name: 'Alex Chen',
    });

    const { status } = await callAuth('/sign-in/email', {
      email: 'alex@example.com',
      password: 'wrong password entirely',
    });

    expect(status).toBe(401);
  });

  it('rejects a sign-up whose password is shorter than the configured minimum', async () => {
    const { status } = await callAuth('/sign-up/email', {
      email: 'short@example.com',
      password: 'short1',
      name: 'Short Password',
    });

    // Better Auth answers a password-policy rejection as a 400, distinct from the 401 a bad
    // credential gets on sign-in — this is a malformed request, not a failed authentication.
    expect(status).toBe(400);
  });
});

describe('deleting a user', () => {
  it('cascades to their profile and application rows instead of failing on the foreign key', async () => {
    const { json } = await callAuth('/sign-up/email', {
      email: 'deleteme@example.com',
      password: 'correct horse battery staple',
      name: 'Delete Me',
    });
    const userId = (json as { user: { id: string } }).user.id;

    // Written directly against the real migrated schema, not through the app's own stores — this
    // test is checking the database's own `ON DELETE cascade` (migration 0011), which a store-level
    // test could not observe.
    await authTestClient.query(`INSERT INTO profiles (user_id, data) VALUES ($1, '{}'::jsonb)`, [
      userId,
    ]);
    await authTestClient.query(
      `INSERT INTO applications (user_id, company, role_title, job_url, job_info, tailored_resume, answers)
       VALUES ($1, 'Acme', 'Engineer', 'https://example.com/job', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [userId],
    );

    await authTestClient.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const profiles = await authTestClient.query(`SELECT 1 FROM profiles WHERE user_id = $1`, [
      userId,
    ]);
    const applications = await authTestClient.query(
      `SELECT 1 FROM applications WHERE user_id = $1`,
      [userId],
    );
    expect(profiles.rows).toHaveLength(0);
    expect(applications.rows).toHaveLength(0);
  });
});
