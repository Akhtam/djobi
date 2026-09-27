/**
 * The LLM routes: validate a body, run one `llm/` operation, answer with its result as JSON.
 * Resource routes (`applications.ts`) and binary ones (`render-resume-pdf.ts`) live separately.
 */
import {
  AnalyzeApplicationRequestSchema,
  AnswerChatRequestSchema,
  ExtractJobRequestSchema,
} from '@djobi/shared';
import { Hono } from 'hono';
import type { z } from 'zod';
import { jsonBody } from '../requestBody.js';
import { analyzeApplication } from '../llm/analyzeApplication.js';
import { answerChat } from '../llm/answerChat.js';
import { extractJob } from '../llm/extractJob.js';

export const llmRoutes = new Hono();

/**
 * Registers one `POST` behind {@link jsonBody} and answers with `respond`'s result. No `try/catch`:
 * `app.onError` decides 400 vs 500. `respond` gets the request's `AbortSignal`, so a disconnected
 * client (panel closed, Re-analyze) stops billed model work.
 */
function post<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  respond: (body: z.infer<Schema>, signal: AbortSignal) => Promise<unknown>,
): void {
  llmRoutes.post(path, jsonBody(schema), async (c) =>
    c.json(await respond(c.req.valid('json'), c.req.raw.signal)),
  );
}

/** Extracts structured Job Info from the candidate-reviewed Job Description. */
post('/extract-job', ExtractJobRequestSchema, (body, signal) =>
  extractJob(body.jobDescription, signal),
);

/**
 * The Analysis Step in one round trip: `extractJob`, then `tailorResume` and `answerQuestions` in
 * parallel (see `llm/analyzeApplication.ts`). `/extract-job` above serves the Log tab and
 * dashboard.
 */
post('/analyze', AnalyzeApplicationRequestSchema, (body, signal) =>
  analyzeApplication(body.jobDescription, body.profile, body.questions, signal),
);

/**
 * One Ask-tab turn. Cold asks and refinements differ only in the body (`currentAnswer`, thread).
 */
post('/answer-chat', AnswerChatRequestSchema, (body, signal) => answerChat(body, signal));
