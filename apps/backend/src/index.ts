/**
 * Backend entrypoint — loads `.env`, then binds the Hono `app` to a real port via
 * `@hono/node-server`. Kept separate from `app.ts` so tests can import the app without starting a
 * server.
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { app } from './app.js';

/**
 * The served app: one request-log line (method, path, status, duration) wrapped around the real one.
 *
 * Two things make this a wrapper rather than an `app.use(logger())` on the imported instance.
 *
 * Hono composes handlers in **registration order**, and `app.ts` has already registered every
 * route by the time this module runs — so middleware added to `app` here sits *after* them in the
 * chain and never runs for a request a route answers. (It still runs for a 404, which is a
 * convincing way to look correct while logging almost nothing.) Mounting `app` underneath a fresh
 * instance puts the logger genuinely first.
 *
 * And the test suite imports `app.ts` directly to drive it with `app.request()`, so keeping the
 * logger out of that module is what stops a few hundred lines of traffic from burying the results.
 */
const server = new Hono();
server.use(logger());
server.route('/', app);

const port = Number(process.env.PORT ?? 5391);

serve({ fetch: server.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`djobi backend listening on http://127.0.0.1:${info.port}`);
});
