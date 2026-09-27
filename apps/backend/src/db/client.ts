import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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

  const pool = new Pool({ connectionString: databaseUrl });
  // An idle client's error is emitted on the pool; without a listener it would crash the process.
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
  cached = drizzle(pool, { schema });
  return cached;
}

/**
 * The Drizzle client over a `pg` connection pool — standard Postgres wire protocol, so one
 * `DATABASE_URL` works for local, Docker or cloud Postgres (ADR-0002). A Worker port would need an
 * HTTP driver in its own entrypoint.
 *
 * Lazily initialized on first query, so importing it (e.g. via `app.ts` in tests) doesn't require
 * `DATABASE_URL`.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(resolveDb(), prop, receiver);
  },
});
