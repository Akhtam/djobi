/**
 * Applies `src/db/migrations` using drizzle-orm's runtime migrator — the same migration files and
 * `__drizzle_migrations` journal `drizzle-kit migrate` uses, but needing only production
 * dependencies. That's what lets the Docker image (whose devDependencies, `drizzle-kit` included,
 * are pruned) migrate its own database: docker-compose.yml runs this as a one-shot `migrate`
 * service before `backend` starts. Resolves the migrations folder relative to this file, so it
 * works from `dist/db/migrate.js` without copying the SQL files into `dist/`.
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
