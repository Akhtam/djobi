/**
 * Applies `src/db/migrations` with drizzle-orm's runtime migrator (same files and journal as
 * `drizzle-kit migrate`, but production dependencies only) — used by Docker Compose's one-shot
 * `migrate` service. Resolves the folder relative to this file, so it works from `dist/`.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set — copy apps/backend/.env.example to .env and fill it in.',
  );
}

const migrationsFolder = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));
const pool = new Pool({ connectionString: databaseUrl });
try {
  await migrate(drizzle(pool), { migrationsFolder });
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
