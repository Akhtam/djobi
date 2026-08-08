import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;

let cached: Db | undefined;

function resolveDb(): Db {
  if (cached) return cached;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set — copy apps/backend/.env.example to .env and fill it in.',
    );
  }

  const sql = neon(databaseUrl);
  cached = drizzle(sql, { schema });
  return cached;
}

/**
 * The Drizzle client used by every route to read/write `profiles` and `applications`. Uses Neon's
 * low-latency HTTP driver (`drizzle-orm/neon-http`) rather than a pooled `pg` connection, since
 * this backend makes one-off queries per request rather than needing cross-request transactions.
 *
 * Lazily initialized on first use, not at import time — so importing this module (or anything
 * that transitively imports it, like a route file) doesn't require `DATABASE_URL` to be set.
 * `DATABASE_URL` is only actually needed when a query runs. This matters for tests: a route test
 * that mocks out the repository layer (e.g. `extract-job.test.ts`, which never touches the
 * database) can still import `app.ts` without a `.env` file, because the repository it doesn't
 * exercise never reaches into `db`.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(resolveDb(), prop, receiver);
  },
});
