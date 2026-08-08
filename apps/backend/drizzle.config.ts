/**
 * Config for the `drizzle-kit` CLI (`pnpm db:generate`, `pnpm db:migrate`). Runs outside the app's
 * own env loading, so it imports `dotenv/config` directly to pick up `DATABASE_URL` from `.env`.
 */
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
});
