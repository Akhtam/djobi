import { ExtractJobRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { extractJob } from '../llm/extractJob.js';

/** `POST /extract-job` — extracts structured job info from a pasted job description. */
export const extractJobRoute = new Hono();

extractJobRoute.post('/extract-job', async (c) => {
  const body = await c.req.json();
  const parsed = ExtractJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const jobInfo = await extractJob(parsed.data.jobDescription);
  return c.json(jobInfo);
});
