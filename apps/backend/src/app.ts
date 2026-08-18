import type { BackendErrorBody } from '@djobi/shared';
import { Hono } from 'hono';
import { StructuredCallError } from './llm/structuredCall.js';
import { answerQuestionsRoute } from './routes/answer-questions.js';
import { applicationsRoute } from './routes/applications.js';
import { extractJobRoute } from './routes/extract-job.js';
import { profileRoute } from './routes/profile.js';
import { renderResumePdfRoute } from './routes/render-resume-pdf.js';
import { tailorResumeRoute } from './routes/tailor-resume.js';

/**
 * The Hono app instance — separated from `index.ts` (which calls `serve()`) so it can be imported
 * and tested via `app.request(...)` without binding a real port.
 */
export const app = new Hono();

/**
 * The one place a thrown error becomes a response. No route has its own `try/catch`, so without
 * this every throw from `llm/` — the model not returning a tool call, or its input failing schema
 * validation (`structuredCall.ts`), or an SDK/network failure — fell through to Hono's default
 * handler and became a *plain-text* `Internal Server Error`. That body isn't JSON, so the
 * extension's `callBackend` blew up parsing it and the real cause was destroyed before anyone
 * could read it. Failures now use the same `{ error }` shape the routes' validation errors
 * already return, so one client-side branch handles both.
 */
app.onError((err, c) => {
  const context = `${c.req.method} ${c.req.path}`;
  if (err instanceof StructuredCallError) {
    console.error(`[djobi] ${context} failed`, {
      name: err.name,
      message: err.message,
      kind: err.kind,
      toolName: err.toolName,
      requestId: err.requestId,
      stopReason: err.stopReason,
    });
  } else {
    console.error(`[djobi] ${context} failed:`, err);
  }

  const body: BackendErrorBody = { error: err.message };

  return c.json(body, 500);
});

app.route('/', extractJobRoute);
app.route('/', profileRoute);
app.route('/', tailorResumeRoute);
app.route('/', answerQuestionsRoute);
app.route('/', renderResumePdfRoute);
app.route('/', applicationsRoute);
