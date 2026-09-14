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
  // pg-pool emits 'error' on the pool (not just a rejected query) when an idle client errors —
  // e.g. a Postgres restart. An EventEmitter with no 'error' listener throws and crashes the
  // process, so this keeps a transient DB hiccup from taking down every in-flight request.
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
  cached = drizzle(pool, { schema });
  return cached;
}

/**
 * The Drizzle client used by every route to read/write `profiles` and `applications`. Uses `pg`
 * (`drizzle-orm/node-postgres`) — a plain wire-protocol connection pool, not an HTTP driver — so
 * the same `DATABASE_URL` works unchanged against a local or Docker Postgres, a self-hosted one,
 * or a serverless cloud database (e.g. Neon): those providers' connection strings speak standard
 * Postgres wire protocol too, and only need their own HTTP drivers (e.g.
 * `@neondatabase/serverless`) when the caller can't open a raw TCP socket at all (a Cloudflare
 * Worker, mainly). This backend runs as a Node process both in dev and in `dist/`, so that
 * constraint doesn't apply here; see `docs/adr/0001-cloudflare-single-worker.md`, whose driver
 * choice this supersedes now that running locally without any cloud account is a goal in its own
 * right — a Worker port, if it happens, can special-case an HTTP driver in its own entrypoint
 * rather than in this shared client.
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
