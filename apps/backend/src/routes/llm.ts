/**
 * The routes that are nothing but a route: validate a body, run one `llm/` operation, answer
 * with what it returned.
 *
 * They were four modules — a `Hono` instance, an import of `parseBody`, and a single `post` each.
 * Nothing was hidden behind any of them: the path was the only fact a module held that its
 * operation didn't, so adding a route meant a new file, a new import in `app.ts`, and a new
 * `app.route` line, none of which said anything. Here a route is one line, and the lines sit
 * where they can be read as a set.
 *
 * `routes/applications.ts` and `routes/render-resume-pdf.ts` stay as they are, and the difference is
 * the point rather than an inconsistency: one holds a REST resource's worth of handlers, while the
 * other returns binary data with PDF-specific response headers. These routes return JSON.
 */
import {
  AnalyzeApplicationRequestSchema,
  AnswerChatRequestSchema,
  AnswerQuestionsRequestSchema,
  ExtractJobRequestSchema,
  TailorResumeRequestSchema,
} from '@djobi/shared';
import { Hono } from 'hono';
import type { z } from 'zod';
import { parseBody } from '../requestBody.js';
import { analyzeApplication } from '../llm/analyzeApplication.js';
import { answerChat } from '../llm/answerChat.js';
import { answerQuestions } from '../llm/answerQuestions.js';
import { extractJob } from '../llm/extractJob.js';
import { tailorResume } from '../llm/tailorResume.js';

export const llmRoutes = new Hono();

/**
 * Registers one `POST` that validates against `schema` and answers with `respond`'s result as JSON.
 *
 * Nothing here catches: a throw from `parseBody` is the client's 400 and a throw from the operation
 * is a 500, both decided in one place by `app.onError`. A `try/catch` per route is exactly what that
 * handler exists to make unnecessary.
 *
 * `respond` is handed the request's own `AbortSignal`, which fires when the candidate's browser
 * disconnects — closing the panel, navigating away, or hitting Re-analyze on a run still in flight.
 * Every operation below is one or more model calls, and a model call keeps generating (and billing)
 * for as long as it is allowed to, whether or not anything is still listening. Passing the signal is
 * what stops an abandoned Analysis Step from finishing at full price.
 */
function post<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
  respond: (body: z.infer<Schema>, signal: AbortSignal) => Promise<unknown>,
): void {
  llmRoutes.post(path, async (c) =>
    c.json(await respond(await parseBody(c, schema), c.req.raw.signal)),
  );
}

/** Extracts structured Job Info from the candidate-reviewed Job Description. */
post('/extract-job', ExtractJobRequestSchema, (body, signal) =>
  extractJob(body.jobDescription, signal),
);

/** Tailors the Profile's resume content toward one Job Info. */
post('/tailor-resume', TailorResumeRequestSchema, (body, signal) =>
  tailorResume(body.profile, body.jobInfo, signal),
);

/** Drafts answers to a form's freeform application questions. */
post('/answer-questions', AnswerQuestionsRequestSchema, (body, signal) =>
  answerQuestions(body.profile, body.jobInfo, body.questions, signal),
);

/**
 * The Analysis Step's own consolidated call — `extractJob`, then `tailorResume` and
 * `answerQuestions` from it in parallel, in one round trip. Additive alongside the three routes
 * above, which stay: the Log tab's Duplicate Guard needs `extractJob` alone, and an extension build
 * older than this route still needs the three-call sequence. See `llm/analyzeApplication.ts`.
 */
post('/analyze', AnalyzeApplicationRequestSchema, (body, signal) =>
  analyzeApplication(body.jobDescription, body.profile, body.questions, signal),
);

/**
 * One turn of the Ask Tab's conversation about a single application question.
 *
 * One route for both flows: a cold ask sends an empty thread and no draft, refining an existing
 * answer sends `currentAnswer` and the thread so far. The difference lives entirely in the body —
 * which is why this is the one operation handed the request whole.
 */
post('/answer-chat', AnswerChatRequestSchema, (body, signal) => answerChat(body, signal));
