/**
 * Backend entrypoint — loads `.env`, then binds the Hono `app` to a real port via
 * `@hono/node-server`. Kept separate from `app.ts` so tests can import the app without starting a
 * server.
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app } from './app.js';

const port = Number(process.env.PORT ?? 5391);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`djobi backend listening on http://127.0.0.1:${info.port}`);
});
