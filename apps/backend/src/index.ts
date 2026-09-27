/**
 * Backend entrypoint: loads `.env` and serves the app with `@hono/node-server`. Separate from
 * `app.ts` so tests import the app without starting a server.
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createApp } from './app.js';
import { requireAuth } from './authMiddleware.js';
import { postgresApplicationStore } from './db/postgresApplicationStore.js';
import { postgresProfileStore } from './db/postgresProfileStore.js';
import { configureOpenRouterKey } from './llm/client.js';

// Node reads the key from `process.env`; a Worker entrypoint (ADR-0001) would pass its
// request-scoped `env` instead.
configureOpenRouterKey(() => process.env.OPENROUTER_API_KEY);

/** The only place the Postgres adapters are named; everything else uses the store interfaces. */
const app = createApp({
  applicationStore: postgresApplicationStore,
  profileStore: postgresProfileStore,
  requireAuth: requireAuth(),
});

// Logger on a wrapper app: middleware added to `app` after its routes would never run for them
// (Hono runs in registration order), and tests importing `app.ts` stay free of request logs.
const server = new Hono();
server.use(logger());
server.route('/', app);

const port = Number(process.env.PORT ?? 5391);

/**
 * `127.0.0.1` by default, never `0.0.0.0` — this server holds an OpenRouter key and a database
 * connection. `HOST` exists for the Docker Compose backend, where `0.0.0.0` means the Docker
 * network (the dashboard's nginx proxy), not the LAN.
 */
const hostname = process.env.HOST || '127.0.0.1';

serve({ fetch: server.fetch, port, hostname }, (info) => {
  console.log(`djobi backend listening on http://${hostname}:${info.port}`);
});
