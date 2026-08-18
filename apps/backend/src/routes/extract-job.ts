import { ExtractJobRequestSchema } from '@djobi/shared';
import { Hono } from 'hono';
import { parseBody } from '../requestBody.js';
import { extractJob } from '../llm/extractJob.js';

/** `POST /extract-job` — extracts structured job info from a pasted job description. */
export const extractJobRoute = new Hono();

extractJobRoute.post('/extract-job', async (c) => {
  const parsed = await parseBody(c, ExtractJobRequestSchema);

  const jobInfo = await extractJob(parsed.jobDescription);
  return c.json(jobInfo);
});
