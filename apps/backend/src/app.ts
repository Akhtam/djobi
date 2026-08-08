import { Hono } from 'hono';
import { extractJobRoute } from './routes/extract-job.js';
import { profileRoute } from './routes/profile.js';

/**
 * The Hono app instance — separated from `index.ts` (which calls `serve()`) so it can be imported
 * and tested via `app.request(...)` without binding a real port.
 */
export const app = new Hono();

app.route('/', extractJobRoute);
app.route('/', profileRoute);
